import {
  assertMap,
  assertObj,
  assertString,
  cloneValue,
  isErrorValue,
  type ErrorValue,
  type Message,
  type Observation,
  type ObjRef,
  type TinyBytecode,
  type WooValue,
  valuesEqual,
  wooError
} from "./types";
import type { CallContext } from "./world";

export type VmHandler = {
  targetPc: number;
  errors: string[];
  stackDepth: number;
};

type VmFrame = {
  ctx: CallContext;
  bytecode: TinyBytecode;
  args: WooValue[];
  stack: WooValue[];
  locals: WooValue[];
  handlers: VmHandler[];
  pc: number;
  ticksRemaining: number;
  startedAt: number;
  activeWallMs: number;
  memoryUsed: number;
};

export type SerializedVmContext = {
  space: ObjRef;
  seq: number;
  session?: string | null;
  actor: ObjRef;
  player: ObjRef;
  caller: ObjRef;
  callerPerms: ObjRef;
  progr: ObjRef;
  thisObj: ObjRef;
  verbName: string;
  definer: ObjRef;
  message: Message;
  observations?: Observation[];
};

export type SerializedVmFrame = {
  ctx: SerializedVmContext;
  bytecode: TinyBytecode;
  args: WooValue[];
  stack: WooValue[];
  locals: WooValue[];
  handlers: VmHandler[];
  pc: number;
  ticksRemaining: number;
  startedAt: number;
  activeWallMs?: number;
  memoryUsed: number;
};

export type SerializedVmTask = {
  version: 1;
  frames: SerializedVmFrame[];
};

export type VmRunResult = {
  result: WooValue;
  observations: Observation[];
};

export class VmSuspendSignal {
  readonly kind = "vm_suspend";

  constructor(
    readonly seconds: number,
    readonly task: SerializedVmTask
  ) {}
}

export class VmReadSignal {
  readonly kind = "vm_read";

  constructor(
    readonly player: ObjRef,
    readonly task: SerializedVmTask
  ) {}
}

export function isVmSuspendSignal(value: unknown): value is VmSuspendSignal {
  return value instanceof VmSuspendSignal;
}

export function isVmReadSignal(value: unknown): value is VmReadSignal {
  return value instanceof VmReadSignal;
}

const DEFAULT_TICKS = 100_000;
const DEFAULT_MEMORY = 4 * 1024 * 1024;
const DEFAULT_WALL_MS = 10_000;
const MAX_VM_FRAMES = 128;
const MAX_RUNTIME_LOCALS = 1_024;
const MAX_RUNTIME_STACK = 4_096;
const BUILTIN_NAMES = [
  "length", "keys", "values", "has", "typeof", "to_string", "min", "max", "floor", "ceil", "round", "abs",
  "now", "create", "move", "moveto", "chparent", "has_flag", "isa", "random", "contents", "location", "task_perms",
  "caller_perms", "set_task_perms", "set_presence", "observe_to_space", "tell",
  "current_location", "current_session", "session_location", "all_locations", "primary_session",
  "is_connected", "idle_seconds",
  "builder_create_object", "builder_chparent", "builder_recycle", "builder_set_property", "builder_inspect", "builder_search",
  "programmer_inspect", "programmer_resolve_verb", "programmer_list_verb", "programmer_search", "programmer_install_verb",
  "programmer_set_verb_info", "programmer_set_property_info", "programmer_trace",
  "editor_invoke", "editor_what", "editor_view", "editor_replace", "editor_insert", "editor_delete", "editor_dry_run", "editor_save", "editor_pause", "editor_abort",
  "str_trim", "str_lower", "str_starts", "str_index", "str_slice", "str_char", "dispatch", "execute_command_plan", "str_join", "collect_prop",
  "to_int", "to_float"
];

export async function runTinyVm(ctx: CallContext, bytecode: TinyBytecode, args: WooValue[]): Promise<WooValue> {
  return (await runVmFrames([makeFrame(ctx, bytecode, args)])).result;
}

export function createSerializedTinyVmTask(ctx: CallContext, bytecode: TinyBytecode, args: WooValue[]): SerializedVmTask {
  return serializeVmFrames([makeFrame(ctx, bytecode, args)]);
}

export async function runSerializedTinyVmTask(world: CallContext["world"], task: SerializedVmTask, observations: Observation[] = []): Promise<VmRunResult> {
  if (task.version !== 1) throw wooError("E_VERSION", "unsupported serialized VM task version", task.version);
  return await runVmFrames(task.frames.map((item) => hydrateVmFrame(world, item, observations)));
}

export async function runSerializedTinyVmTaskWithInput(
  world: CallContext["world"],
  task: SerializedVmTask,
  input: WooValue,
  observations: Observation[] = []
): Promise<VmRunResult> {
  const resumed = structuredClone(task);
  const top = resumed.frames[resumed.frames.length - 1];
  if (!top) throw wooError("E_INTERNAL", "serialized VM task has no frames");
  if (top.stack.length >= top.bytecode.max_stack) throw wooError("E_RANGE", "stack overflow");
  top.stack.push(cloneValue(input));
  return await runSerializedTinyVmTask(world, resumed, observations);
}

async function runVmFrames(frames: VmFrame[]): Promise<VmRunResult> {
  const observations = frames[0]?.ctx.observations ?? [];
  let result: WooValue = null;

  const frame = (): VmFrame => {
    const current = frames[frames.length - 1];
    if (!current) throw wooError("E_INTERNAL", "VM has no current frame");
    return current;
  };

  const pop = (): WooValue => {
    const stack = frame().stack;
    if (stack.length === 0) throw wooError("E_RANGE", "stack underflow");
    return stack.pop()!;
  };
  const peek = (): WooValue => {
    const stack = frame().stack;
    if (stack.length === 0) throw wooError("E_RANGE", "stack underflow");
    return stack[stack.length - 1];
  };
  const push = (value: WooValue): void => {
    const current = frame();
    if (current.stack.length >= current.bytecode.max_stack) throw wooError("E_RANGE", "stack overflow");
    current.stack.push(cloneValue(value));
  };
  const jump = (currentPc: number, offset: WooValue): void => {
    frame().pc = currentPc + numeric(offset, "jump offset") + 1;
  };
  const allocate = (value: WooValue): WooValue => {
    const current = frame();
    // Memory accounting is intentionally monotone within a task. Popping a
    // value does not refund budget, matching the VM spec's exhaustion model.
    current.memoryUsed += estimateSize(value);
    if (current.memoryUsed > (current.bytecode.max_memory ?? DEFAULT_MEMORY)) throw wooError("E_MEM", "VM memory budget exceeded");
    return value;
  };
  const raise = (error: ErrorValue): boolean => {
    while (frames.length > 0) {
      const current = frame();
      while (current.handlers.length > 0) {
        const handler = current.handlers.pop()!;
        if (handler.errors.length !== 0 && !handler.errors.includes(error.code)) continue;
        current.stack.length = handler.stackDepth;
        if (current.stack.length >= current.bytecode.max_stack) return false;
        current.stack.push(cloneValue(error as WooValue));
        current.pc = handler.targetPc;
        return true;
      }
      frames.pop();
    }
    return false;
  };
  const pushFrame = (callCtx: CallContext, callBytecode: TinyBytecode, callArgs: WooValue[]): void => {
    if (frames.length >= MAX_VM_FRAMES) throw wooError("E_CALL_DEPTH", "maximum VM frame depth exceeded");
    frames.push(makeFrame(callCtx, callBytecode, callArgs));
  };
  const returnFromFrame = (value: WooValue): void => {
    frames.pop();
    if (frames.length === 0) {
      result = cloneValue(value);
      return;
    }
    push(value);
  };
  const callVerb = async (obj: string, name: string, callArgs: WooValue[], startAt?: string | null): Promise<void> => {
    const caller = frame();
    if (await caller.ctx.world.isRemoteObject(obj) || (startAt ? await caller.ctx.world.isRemoteObject(startAt) : false)) {
      const value = await caller.ctx.world.dispatch({ ...caller.ctx, caller: caller.ctx.thisObj, callerPerms: caller.ctx.progr }, obj, name, callArgs, startAt);
      push(value);
      return;
    }
    const { definer, verb } = startAt === undefined ? caller.ctx.world.resolveVerb(obj, name) : caller.ctx.world.resolveVerbFrom(startAt, name);
    caller.ctx.world.assertCanExecuteVerb(caller.ctx.progr, obj, name, verb);
    const callCtx: CallContext = {
      ...caller.ctx,
      thisObj: obj,
      verbName: name,
      definer,
      progr: verb.owner,
      player: caller.ctx.player ?? caller.ctx.actor,
      caller: caller.ctx.thisObj,
      callerPerms: caller.ctx.progr
    };
    if (verb.kind === "native") {
      const value = await caller.ctx.world.dispatch({ ...caller.ctx, caller: caller.ctx.thisObj, callerPerms: caller.ctx.progr }, obj, name, callArgs, startAt);
      push(value);
      return;
    }
    pushFrame(callCtx, verb.bytecode, callArgs);
  };

  while (frames.length > 0) {
    const current = frame();
    if (current.pc >= current.bytecode.ops.length) {
      returnFromFrame(null);
      continue;
    }

    const currentPc = current.pc;
    const [op, operand, operand2, operand3] = current.bytecode.ops[current.pc];
    current.pc += 1;
    try {
      current.ticksRemaining -= tickWeight(op);
      if (current.ticksRemaining < 0) throw wooError("E_TICKS", "VM tick budget exceeded");
      if (current.activeWallMs + Date.now() - current.startedAt > (current.bytecode.max_wall_ms ?? DEFAULT_WALL_MS)) {
        throw wooError("E_TIMEOUT", "VM wall-time budget exceeded");
      }

      switch (op) {
        case "PUSH_LIT":
          push(literal(current.bytecode, operand));
          break;
        case "PUSH_INT":
          push(numeric(operand, "inline integer"));
          break;
        case "PUSH_LOCAL":
          push(current.locals[localIndex(operand, current.locals.length)] ?? null);
          break;
        case "POP_LOCAL":
          current.locals[localIndex(operand, current.locals.length)] = pop();
          break;
        case "PUSH_THIS":
          push(current.ctx.thisObj);
          break;
        case "PUSH_ACTOR":
          push(current.ctx.actor);
          break;
        case "PUSH_PLAYER":
          push(current.ctx.player ?? current.ctx.actor);
          break;
        case "PUSH_CALLER":
          push(current.ctx.caller);
          break;
        case "PUSH_PROGR":
          push(current.ctx.progr);
          break;
        case "PUSH_VERB":
          push(current.ctx.verbName);
          break;
        case "PUSH_ARGS":
          push(current.args);
          break;
        case "PUSH_SPACE":
          push(current.ctx.space);
          break;
        case "PUSH_SEQ":
          push(current.ctx.seq);
          break;
        case "PUSH_MESSAGE":
          push(current.ctx.message as unknown as WooValue);
          break;
        case "PUSH_ARG":
          push(current.args[numeric(operand, "arg index")] ?? null);
          break;
        case "POP":
          pop();
          break;
        case "DUP":
          push(peek());
          break;
        case "SWAP": {
          const right = pop();
          const left = pop();
          push(right);
          push(left);
          break;
        }

        case "ADD":
          binaryArithmetic("ADD");
          break;
        case "SUB":
          numericBinary((left, right) => left - right);
          break;
        case "MUL":
          multiply();
          break;
        case "DIV":
          divide();
          break;
        case "MOD":
          numericBinary((left, right) => {
            if (right === 0) throw wooError("E_DIV", "division by zero");
            return left % right;
          });
          break;
        case "NEG":
          push(-numeric(pop(), "operand"));
          break;
        case "NOT":
          push(!truthy(pop()));
          break;
        case "EQ": {
          const right = pop();
          const left = pop();
          push(valuesEqual(left, right));
          break;
        }
        case "NEQ": {
          const right = pop();
          const left = pop();
          push(!valuesEqual(left, right));
          break;
        }
        case "LT":
          compare((left, right) => left < right);
          break;
        case "LE":
          compare((left, right) => left <= right);
          break;
        case "GT":
          compare((left, right) => left > right);
          break;
        case "GE":
          compare((left, right) => left >= right);
          break;
        case "IN":
          membership();
          break;

        case "JUMP":
          jump(currentPc, operand);
          break;
        case "JUMP_IF_TRUE": {
          const value = pop();
          if (truthy(value)) jump(currentPc, operand);
          break;
        }
        case "JUMP_IF_FALSE": {
          const value = pop();
          if (!truthy(value)) jump(currentPc, operand);
          break;
        }
        case "JUMP_IF_TRUE_KEEP":
          if (truthy(peek())) jump(currentPc, operand);
          break;
        case "JUMP_IF_FALSE_KEEP":
          if (!truthy(peek())) jump(currentPc, operand);
          break;

        case "FOR_LIST_INIT": {
          const list = assertList(pop());
          push(list);
          push(0);
          current.locals[localIndex(operand, current.locals.length)] = null;
          break;
        }
        case "FOR_LIST_NEXT": {
          const index = numeric(peek(), "list iterator index");
          const list = assertList(current.stack[current.stack.length - 2]);
          if (index >= list.length) {
            jump(currentPc, operand2);
          } else {
            current.locals[localIndex(operand, current.locals.length)] = cloneValue(list[index]);
            current.stack[current.stack.length - 1] = index + 1;
          }
          break;
        }
        case "FOR_RANGE_INIT": {
          const lo = numeric(pop(), "range low");
          const hi = numeric(pop(), "range high");
          push(hi);
          push(lo);
          current.locals[localIndex(operand, current.locals.length)] = lo;
          break;
        }
        case "FOR_RANGE_NEXT": {
          const next = numeric(peek(), "range iterator value");
          const hi = numeric(current.stack[current.stack.length - 2], "range high");
          if (next > hi) {
            jump(currentPc, operand2);
          } else {
            current.locals[localIndex(operand, current.locals.length)] = next;
            current.stack[current.stack.length - 1] = next + 1;
          }
          break;
        }
        case "FOR_MAP_INIT": {
          const map = assertMap(pop());
          push(map);
          push(0);
          break;
        }
        case "FOR_MAP_NEXT": {
          const index = numeric(peek(), "map iterator index");
          const map = assertMap(current.stack[current.stack.length - 2]);
          const entries = Object.entries(map);
          if (index >= entries.length) {
            jump(currentPc, operand3);
          } else {
            const [key, value] = entries[index];
            current.locals[localIndex(operand, current.locals.length)] = key;
            current.locals[localIndex(operand2, current.locals.length)] = cloneValue(value);
            current.stack[current.stack.length - 1] = index + 1;
          }
          break;
        }
        case "FOR_END":
          pop();
          pop();
          break;

        case "GET_PROP": {
          const name = assertString(pop());
          const obj = assertObj(pop());
          push(await current.ctx.world.getPropChecked(current.ctx.progr, obj, name, current.ctx.hostMemo));
          break;
        }
        case "SET_PROP": {
          const value = pop();
          const name = assertString(pop());
          const obj = assertObj(pop());
          await current.ctx.world.setPropChecked(current.ctx.progr, obj, name, value);
          break;
        }
        case "HAS_PROP": {
          const name = assertString(pop());
          const obj = assertObj(pop());
          push(current.ctx.world.properties(obj).includes(name));
          break;
        }
        case "DEFINE_PROP": {
          const perms = assertString(pop());
          const defaultValue = pop();
          const name = assertString(pop());
          const obj = assertObj(pop());
          await current.ctx.world.definePropertyChecked(current.ctx.progr, obj, { name, defaultValue, perms, owner: current.ctx.progr });
          break;
        }
        case "UNDEFINE_PROP": {
          const name = assertString(pop());
          const obj = assertObj(pop());
          await current.ctx.world.undefinePropertyChecked(current.ctx.progr, obj, name);
          break;
        }
        case "PROP_INFO": {
          const name = assertString(pop());
          const obj = assertObj(pop());
          push(current.ctx.world.propertyInfo(obj, name) as WooValue);
          break;
        }
        case "SET_PROP_INFO": {
          const info = assertMap(pop());
          const name = assertString(pop());
          const obj = assertObj(pop());
          await current.ctx.world.setPropertyInfoChecked(current.ctx.progr, obj, name, info);
          break;
        }

        case "CALL_VERB": {
          const callArgs = popArgs(numeric(operand, "argc"));
          const name = assertString(pop());
          const obj = assertObj(pop());
          await callVerb(obj, name, callArgs);
          break;
        }
        case "PASS": {
          const callArgs = popArgs(numeric(operand, "argc"));
          const parent = current.ctx.world.object(current.ctx.definer).parent;
          if (!parent) throw wooError("E_VERBNF", `no parent verb for ${current.ctx.verbName}`);
          await callVerb(current.ctx.thisObj, current.ctx.verbName, callArgs, parent);
          break;
        }
        case "RETURN": {
          const value = pop();
          returnFromFrame(value);
          break;
        }
        case "RAISE":
        case "FAIL": {
          const error = errorFromValue(pop());
          throw error;
        }
        case "BUILTIN": {
          const builtinArgs = popArgs(numeric(operand2, "builtin argc"));
          const fast = tryFastBuiltin(operand, builtinArgs, current);
          push(fast.handled ? fast.value : await callBuiltin(operand, builtinArgs, current));
          break;
        }

        case "LIST_GET": {
          const index = oneBasedIndex(pop());
          const list = assertList(pop());
          if (index < 0 || index >= list.length) throw wooError("E_RANGE", "list index out of range", index + 1);
          push(list[index]);
          break;
        }
        case "LIST_SET": {
          const value = pop();
          const index = oneBasedIndex(pop());
          const list = assertList(pop());
          if (index < 0 || index >= list.length) throw wooError("E_RANGE", "list index out of range", index + 1);
          const next = [...list];
          next[index] = value;
          push(allocate(next));
          break;
        }
        case "LIST_APPEND": {
          const value = pop();
          const list = assertList(pop());
          push(allocate([...list, value]));
          break;
        }
        case "MAP_GET": {
          const key = assertString(pop());
          const map = assertMap(pop());
          if (!(key in map)) throw wooError("E_PROPNF", `map key not found: ${key}`);
          push(map[key]);
          break;
        }
        case "MAP_SET": {
          const value = pop();
          const key = assertString(pop());
          const map = assertMap(pop());
          push(allocate({ ...map, [key]: value }));
          break;
        }
        case "INDEX_GET": {
          const key = pop();
          const collection = pop();
          if (Array.isArray(collection)) {
            const index = oneBasedIndex(key);
            if (index < 0 || index >= collection.length) throw wooError("E_RANGE", "list index out of range", index + 1);
            push(collection[index]);
          } else {
            const map = assertMap(collection);
            const mapKey = assertString(key);
            if (!(mapKey in map)) throw wooError("E_PROPNF", `map key not found: ${mapKey}`);
            push(map[mapKey]);
          }
          break;
        }
        case "INDEX_SET": {
          const value = pop();
          const key = pop();
          const collection = pop();
          if (Array.isArray(collection)) {
            const index = oneBasedIndex(key);
            if (index < 0 || index >= collection.length) throw wooError("E_RANGE", "list index out of range", index + 1);
            const next = [...collection];
            next[index] = value;
            push(allocate(next));
          } else {
            const map = assertMap(collection);
            const mapKey = assertString(key);
            push(allocate({ ...map, [mapKey]: value }));
          }
          break;
        }
        case "MAKE_MAP": {
          const count = numeric(operand, "map entry count");
          const entries: [string, WooValue][] = [];
          for (let i = 0; i < count; i++) {
            const value = pop();
            const key = assertString(pop());
            entries.unshift([key, value]);
          }
          push(allocate(Object.fromEntries(entries)));
          break;
        }
        case "MAKE_LIST": {
          const count = numeric(operand, "list count");
          const values: WooValue[] = [];
          for (let i = 0; i < count; i++) values.unshift(pop());
          push(allocate(values));
          break;
        }
        case "STR_CONCAT":
        case "STR_INTERP": {
          const count = numeric(operand, "string count");
          const parts: string[] = [];
          for (let i = 0; i < count; i++) parts.unshift(assertString(pop()));
          push(allocate(parts.join("")));
          break;
        }
        case "SPLAT": {
          const list = assertList(pop());
          for (const value of list) push(value);
          break;
        }

        case "OBSERVE": {
          const event = assertMap(pop());
          const type = assertString(event.type);
          current.ctx.observe({ ...event, type });
          break;
        }
        case "EMIT": {
          const event = assertMap(pop());
          const target = pop();
          const type = assertString(event.type);
          current.ctx.observe({ target, ...event, type });
          break;
        }
        case "YIELD":
          break;
        case "FORK": {
          const forkArgs = popArgs(numeric(operand, "argc"));
          const verbName = assertString(pop());
          const obj = assertObj(pop());
          const seconds = numeric(pop(), "fork delay");
          push(current.ctx.world.scheduleFork(current.ctx, seconds, obj, verbName, forkArgs));
          break;
        }
        case "SUSPEND": {
          const seconds = numeric(pop(), "suspend delay");
          push(0);
          throw new VmSuspendSignal(seconds, serializeVmFrames(frames));
        }
        case "READ": {
          const player = assertObj(pop());
          throw new VmReadSignal(player, serializeVmFrames(frames));
        }

        case "TRY_PUSH": {
          const errorsValue = operand2 === undefined ? [] : literal(current.bytecode, operand2);
          const errors = Array.isArray(errorsValue) ? errorsValue.map((value) => assertString(value)) : [];
          current.handlers.push({ targetPc: currentPc + numeric(operand, "catch offset") + 1, errors, stackDepth: current.stack.length });
          break;
        }
        case "TRY_POP":
          if (!current.handlers.pop()) throw wooError("E_RANGE", "handler stack underflow");
          break;

        default:
          throw wooError("E_INVARG", `unknown VM opcode: ${op}`);
      }
    } catch (err) {
      if (isVmSuspendSignal(err)) throw err;
      if (isVmReadSignal(err)) throw err;
      const error = attachVmTrace(normalizeVmError(err), frames, currentPc);
      if (!raise(error)) throw error;
    }
  }

  return { result, observations };

  function popArgs(count: number): WooValue[] {
    const values: WooValue[] = [];
    for (let i = 0; i < count; i++) values.unshift(pop());
    return values;
  }

  function binaryArithmetic(op: "ADD"): void {
    const right = pop();
    const left = pop();
    if (typeof left === "number" && typeof right === "number") {
      push(left + right);
    } else if (typeof left === "string" && typeof right === "string") {
      push(allocate(left + right));
    } else if (Array.isArray(left) && Array.isArray(right)) {
      push(allocate([...left, ...right]));
    } else {
      throw wooError("E_TYPE", `${op} operands are incompatible`, { left, right });
    }
  }

  function numericBinary(fn: (left: number, right: number) => number): void {
    const right = numeric(pop(), "right operand");
    const left = numeric(pop(), "left operand");
    push(fn(left, right));
  }

  function multiply(): void {
    const right = pop();
    const left = pop();
    if (typeof left === "number" && typeof right === "number") {
      push(left * right);
    } else if (typeof left === "number" && typeof right === "string" && Number.isInteger(left)) {
      push(allocate(right.repeat(Math.max(0, left))));
    } else if (typeof left === "string" && typeof right === "number" && Number.isInteger(right)) {
      push(allocate(left.repeat(Math.max(0, right))));
    } else {
      throw wooError("E_TYPE", "MUL operands are incompatible", { left, right });
    }
  }

  function divide(): void {
    const right = numeric(pop(), "right operand");
    const left = numeric(pop(), "left operand");
    if (right === 0) throw wooError("E_DIV", "division by zero");
    push(Number.isInteger(left) && Number.isInteger(right) ? Math.trunc(left / right) : left / right);
  }

  function compare(fn: (left: number | string, right: number | string) => boolean): void {
    const right = pop();
    const left = pop();
    if (typeof left === "number" && typeof right === "number") push(fn(left, right));
    else if (typeof left === "string" && typeof right === "string") push(fn(left, right));
    else throw wooError("E_TYPE", "comparison operands are incompatible", { left, right });
  }

  function membership(): void {
    const haystack = pop();
    const needle = pop();
    if (Array.isArray(haystack)) {
      push(haystack.some((value) => valuesEqual(value, needle)));
      return;
    }
    if (haystack !== null && typeof haystack === "object" && !Array.isArray(haystack)) {
      push(typeof needle === "string" && needle in haystack);
      return;
    }
    throw wooError("E_TYPE", "IN requires list or map haystack", haystack);
  }

  async function callBuiltin(nameOrIndex: WooValue | undefined, builtinArgs: WooValue[], frame: VmFrame): Promise<WooValue> {
    const name = typeof nameOrIndex === "number" ? BUILTIN_NAMES[nameOrIndex] : assertString(nameOrIndex ?? "");
    switch (name) {
      case "length": {
        const value = builtinArgs[0];
        if (typeof value === "string" || Array.isArray(value)) return value.length;
        if (value !== null && typeof value === "object") return Object.keys(value).length;
        throw wooError("E_TYPE", "length requires string, list, or map", value);
      }
      case "keys":
        return Object.keys(assertMap(builtinArgs[0]));
      case "values":
        return Object.values(assertMap(builtinArgs[0]));
      case "has": {
        const collection = builtinArgs[0];
        const key = builtinArgs[1];
        if (Array.isArray(collection)) return collection.some((value) => valuesEqual(value, key));
        if (collection !== null && typeof collection === "object") return typeof key === "string" && key in collection;
        return false;
      }
      case "typeof":
        return typeName(builtinArgs[0]);
      case "to_string":
        return typeof builtinArgs[0] === "string" ? builtinArgs[0] : JSON.stringify(builtinArgs[0]);
      case "to_int": {
        const v = builtinArgs[0];
        if (typeof v === "number") return Math.trunc(v);
        if (typeof v === "boolean") return v ? 1 : 0;
        if (typeof v === "string") {
          const trimmed = v.trim();
          if (!trimmed) return 0;
          const n = Number(trimmed);
          if (!Number.isFinite(n)) return 0;
          return Math.trunc(n);
        }
        if (v === null) return 0;
        return 0;
      }
      case "to_float": {
        const v = builtinArgs[0];
        if (typeof v === "number") return v;
        if (typeof v === "boolean") return v ? 1 : 0;
        if (typeof v === "string") {
          const trimmed = v.trim();
          if (!trimmed) return 0;
          const n = Number(trimmed);
          return Number.isFinite(n) ? n : 0;
        }
        if (v === null) return 0;
        return 0;
      }
      case "str_trim":
        return assertString(builtinArgs[0] ?? "").trim();
      case "str_lower":
        return assertString(builtinArgs[0] ?? "").toLowerCase();
      case "str_starts":
        if (builtinArgs.length !== 2) throw wooError("E_INVARG", "str_starts expects text and prefix");
        return assertString(builtinArgs[0] ?? "").startsWith(assertString(builtinArgs[1] ?? ""));
      case "str_index": {
        if (builtinArgs.length !== 2) throw wooError("E_INVARG", "str_index expects text and needle");
        const index = assertString(builtinArgs[0] ?? "").indexOf(assertString(builtinArgs[1] ?? ""));
        return index < 0 ? 0 : index + 1;
      }
      case "str_slice": {
        if (builtinArgs.length < 2 || builtinArgs.length > 3) throw wooError("E_INVARG", "str_slice expects text, start, and optional end");
        const text = assertString(builtinArgs[0] ?? "");
        const start = Math.max(1, Math.floor(numeric(builtinArgs[1], "str_slice start")));
        const end = builtinArgs.length >= 3 && builtinArgs[2] !== null
          ? Math.max(0, Math.floor(numeric(builtinArgs[2], "str_slice end")))
          : text.length;
        if (end < start) return "";
        return text.slice(start - 1, end);
      }
      case "str_char": {
        if (builtinArgs.length !== 1) throw wooError("E_INVARG", "str_char expects a code point");
        const code = numeric(builtinArgs[0], "str_char code point");
        if (!Number.isInteger(code) || code < 0 || code > 0x10FFFF) throw wooError("E_RANGE", "invalid code point", code);
        return String.fromCodePoint(code);
      }
      case "str_join": {
        if (builtinArgs.length !== 2) throw wooError("E_INVARG", "str_join expects list and separator");
        const list = assertList(builtinArgs[0]);
        const separator = assertString(builtinArgs[1] ?? "");
        return list.map((item) => typeof item === "string" ? item : JSON.stringify(item)).join(separator);
      }
      case "min":
        return Math.min(...builtinArgs.map((value) => numeric(value, "min argument")));
      case "max":
        return Math.max(...builtinArgs.map((value) => numeric(value, "max argument")));
      case "floor":
        return Math.floor(numeric(builtinArgs[0], "floor argument"));
      case "ceil":
        return Math.ceil(numeric(builtinArgs[0], "ceil argument"));
      case "round":
        return Math.round(numeric(builtinArgs[0], "round argument"));
      case "abs":
        return Math.abs(numeric(builtinArgs[0], "abs argument"));
      case "now":
        return Date.now();
      case "create": {
        chargeTicks(frame, 45);
        const parent = assertObj(builtinArgs[0]);
        let owner = frame.ctx.actor;
        let options: {
          name?: string;
          description?: string;
          aliases?: string[];
          location?: ObjRef | null;
          fertile?: boolean;
        } = {};
        const createArg = builtinArgs[1];
        if (createArg === undefined || createArg === null) {
          owner = frame.ctx.actor;
        } else if (typeof createArg === "object" && !Array.isArray(createArg)) {
          const map = assertMap(createArg);
          owner = map.owner === undefined || map.owner === null ? frame.ctx.actor : assertObj(map.owner);
          options = {
            name: typeof map.name === "string" ? map.name : undefined,
            description: typeof map.description === "string" ? map.description : undefined,
            aliases: Array.isArray(map.aliases) ? map.aliases.filter((item): item is string => typeof item === "string") : undefined,
            location: map.location === undefined || map.location === null ? null : assertObj(map.location),
            fertile: typeof map.fertile === "boolean" ? map.fertile : undefined
          };
        } else {
          owner = assertObj(createArg);
        }
        const anchor = frame.ctx.space === "#-1" ? null : frame.ctx.space;
        return frame.ctx.world.createRuntimeObject(parent, owner, anchor, { progr: frame.ctx.progr, ...options });
      }
      case "move": {
        if (builtinArgs.length !== 2) throw wooError("E_INVARG", "move expects object and destination");
        await frame.ctx.world.moveAuthoredObjectChecked(frame.ctx.progr, assertObj(builtinArgs[0]), assertObj(builtinArgs[1]), frame.ctx);
        return true;
      }
      case "moveto": {
        if (builtinArgs.length !== 2) throw wooError("E_INVARG", "moveto expects object and target");
        return await frame.ctx.world.movetoChecked(frame.ctx, assertObj(builtinArgs[0]), assertObj(builtinArgs[1]));
      }
      case "chparent": {
        if (builtinArgs.length !== 2) throw wooError("E_INVARG", "chparent expects object and new parent");
        frame.ctx.world.chparentAuthoredObject(frame.ctx.progr, assertObj(builtinArgs[0]), assertObj(builtinArgs[1]));
        return true;
      }
      case "has_flag": {
        const obj = frame.ctx.world.object(assertObj(builtinArgs[0]));
        const flag = assertString(builtinArgs[1]);
        return (obj.flags as Record<string, boolean | undefined>)[flag] === true;
      }
      case "is_connected": {
        if (builtinArgs.length !== 1) throw wooError("E_INVARG", "is_connected expects one actor");
        return frame.ctx.world.actorIsConnected(assertObj(builtinArgs[0]));
      }
      case "idle_seconds": {
        if (builtinArgs.length !== 1) throw wooError("E_INVARG", "idle_seconds expects one actor");
        const at = frame.ctx.world.actorLastInputAt(assertObj(builtinArgs[0]));
        return at === null ? null : Math.max(0, Math.floor((Date.now() - at) / 1000));
      }
      case "isa": {
        if (builtinArgs.length !== 2) throw wooError("E_INVARG", "isa expects object and ancestor");
        return frame.ctx.world.isDescendantOfChecked(assertObj(builtinArgs[0]), assertObj(builtinArgs[1]), frame.ctx.hostMemo);
      }
      case "random": {
        const n = numeric(builtinArgs[0], "random argument");
        if (!Number.isInteger(n) || n <= 0) throw wooError("E_INVARG", "random(n) requires a positive integer", builtinArgs[0]);
        return Math.floor(Math.random() * n);
      }
      case "contents": {
        const obj = frame.ctx.world.object(assertObj(builtinArgs[0]));
        return Array.from(obj.contents);
      }
      case "location": {
        if (builtinArgs.length !== 1) throw wooError("E_INVARG", "location expects one object");
        const obj = assertObj(builtinArgs[0]);
        if (obj === frame.ctx.actor && frame.ctx.session) return frame.ctx.world.currentLocationForSession(frame.ctx.session);
        return await frame.ctx.world.objectLocationChecked(obj, frame.ctx.hostMemo);
      }
      case "current_location": {
        if (builtinArgs.length !== 0) throw wooError("E_INVARG", "current_location expects no arguments");
        return frame.ctx.world.currentLocationForSession(frame.ctx.session);
      }
      case "current_session": {
        if (builtinArgs.length !== 0) throw wooError("E_INVARG", "current_session expects no arguments");
        return frame.ctx.session;
      }
      case "session_location": {
        if (builtinArgs.length !== 1) throw wooError("E_INVARG", "session_location expects one session id");
        return frame.ctx.world.currentLocationForSession(String(builtinArgs[0] ?? ""));
      }
      case "all_locations": {
        if (builtinArgs.length !== 1) throw wooError("E_INVARG", "all_locations expects one object");
        const obj = assertObj(builtinArgs[0]);
        const actorCheck = frame.ctx.world.isDescendantOfChecked(obj, "$actor", frame.ctx.hostMemo);
        if (isPromiseLike(actorCheck) ? await actorCheck : actorCheck) {
          if (await frame.ctx.world.isRemoteObject(obj, frame.ctx.hostMemo)) return await frame.ctx.world.getHostBridge()?.actorSessionLocations?.(obj, frame.ctx.hostMemo) ?? [];
          return frame.ctx.world.allLocationsForActor(obj);
        }
        const loc = await frame.ctx.world.objectLocationChecked(obj, frame.ctx.hostMemo);
        return loc ? [loc] : [];
      }
      case "primary_session": {
        if (builtinArgs.length !== 1) throw wooError("E_INVARG", "primary_session expects one actor");
        return frame.ctx.world.primarySessionForActor(assertObj(builtinArgs[0]))?.id ?? null;
      }
      case "task_perms":
        if (builtinArgs.length !== 0) throw wooError("E_INVARG", "task_perms expects no arguments");
        return frame.ctx.progr;
      case "caller_perms":
        if (builtinArgs.length !== 0) throw wooError("E_INVARG", "caller_perms expects no arguments");
        return frame.ctx.callerPerms;
      case "set_task_perms": {
        if (builtinArgs.length !== 1) throw wooError("E_INVARG", "set_task_perms expects one actor");
        const next = assertObj(builtinArgs[0]);
        frame.ctx.world.object(next);
        if (next !== frame.ctx.progr && !frame.ctx.world.object(frame.ctx.progr).flags.wizard) {
          throw wooError("E_PERM", `${frame.ctx.progr} cannot set task perms to ${next}`, { progr: frame.ctx.progr, next });
        }
        frame.ctx.progr = next;
        return next;
      }
      case "set_presence": {
        if (builtinArgs.length !== 2) throw wooError("E_INVARG", "set_presence expects space and present");
        const present = builtinArgs[1];
        if (typeof present !== "boolean") throw wooError("E_TYPE", "set_presence present argument must be boolean", present);
        return await frame.ctx.world.setPresenceForActor(frame.ctx.actor, assertObj(builtinArgs[0]), present, frame.ctx);
      }
      case "observe_to_space": {
        if (builtinArgs.length !== 2) throw wooError("E_INVARG", "observe_to_space expects space and event");
        const event = assertMap(builtinArgs[1]);
        await frame.ctx.world.observeToSpace(frame.ctx, assertObj(builtinArgs[0]), { ...event, type: assertString(event.type) });
        return null;
      }
      case "tell": {
        if (builtinArgs.length < 2) throw wooError("E_INVARG", "tell expects actor and text");
        frame.ctx.world.tellPlayer(frame.ctx, assertObj(builtinArgs[0]), builtinArgs.slice(1));
        return null;
      }
      case "dispatch": {
        if (builtinArgs.length < 2 || builtinArgs.length > 4) throw wooError("E_INVARG", "dispatch expects target, verb, optional args, and optional start_at");
        const callArgs = builtinArgs.length >= 3 && builtinArgs[2] !== null ? assertList(builtinArgs[2]) : [];
        const startAt = builtinArgs.length >= 4 && builtinArgs[3] !== null ? assertObj(builtinArgs[3]) : undefined;
        return await frame.ctx.world.dispatch(
          { ...frame.ctx, caller: frame.ctx.thisObj, callerPerms: frame.ctx.progr },
          assertObj(builtinArgs[0]),
          assertString(builtinArgs[1]),
          callArgs,
          startAt
        );
      }
      case "execute_command_plan": {
        if (builtinArgs.length !== 1) throw wooError("E_INVARG", "execute_command_plan expects one plan");
        return await frame.ctx.world.executeCommandPlan(frame.ctx, assertMap(builtinArgs[0]));
      }
      case "collect_prop": {
        if (builtinArgs.length !== 2) throw wooError("E_INVARG", "collect_prop expects list and property name");
        const refs = assertList(builtinArgs[0]).map((item, index) => {
          try {
            return assertObj(item);
          } catch {
            throw wooError("E_TYPE", `collect_prop item ${index + 1} must be an object reference`, { index: index + 1, value: item });
          }
        });
        chargeTicks(frame, refs.length);
        const prop = assertString(builtinArgs[1]);
        return await frame.ctx.world.collectPropChecked(frame.ctx.progr, refs, prop, frame.ctx.hostMemo, { parallel: frame.ctx.seq < 0 });
      }
      case "builder_create_object":
        if (builtinArgs.length < 1 || builtinArgs.length > 2) throw wooError("E_INVARG", "builder_create_object expects parent and optional opts");
        return await frame.ctx.world.builderCreateObject(frame.ctx.actor, assertObj(builtinArgs[0]), builtinArgs[1] ?? null, frame.ctx.definer);
      case "builder_chparent":
        if (builtinArgs.length < 2 || builtinArgs.length > 3) throw wooError("E_INVARG", "builder_chparent expects object, parent, and optional opts");
        return await frame.ctx.world.builderChparent(frame.ctx.actor, assertObj(builtinArgs[0]), assertObj(builtinArgs[1]), builtinArgs[2] ?? null, frame.ctx.definer);
      case "builder_recycle":
        if (builtinArgs.length < 1 || builtinArgs.length > 2) throw wooError("E_INVARG", "builder_recycle expects object and optional opts");
        return await frame.ctx.world.builderRecycle(frame.ctx.actor, assertObj(builtinArgs[0]), builtinArgs[1] ?? null, frame.ctx.definer);
      case "builder_set_property":
        if (builtinArgs.length < 3 || builtinArgs.length > 4) throw wooError("E_INVARG", "builder_set_property expects object, name, value, and optional opts");
        return await frame.ctx.world.builderSetProperty(frame.ctx.actor, assertObj(builtinArgs[0]), assertString(builtinArgs[1]), builtinArgs[2], builtinArgs[3] ?? null, frame.ctx.definer);
      case "builder_inspect":
        if (builtinArgs.length < 1 || builtinArgs.length > 2) throw wooError("E_INVARG", "builder_inspect expects object and optional opts");
        return frame.ctx.world.builderInspect(frame.ctx.actor, assertObj(builtinArgs[0]), builtinArgs[1] ?? null, frame.ctx.definer);
      case "builder_search":
        if (builtinArgs.length < 1 || builtinArgs.length > 2) throw wooError("E_INVARG", "builder_search expects query and optional opts");
        return frame.ctx.world.builderSearch(frame.ctx.actor, assertString(builtinArgs[0]), builtinArgs[1] ?? null, frame.ctx.definer);
      case "programmer_inspect":
        if (builtinArgs.length < 1 || builtinArgs.length > 2) throw wooError("E_INVARG", "programmer_inspect expects object and optional opts");
        return frame.ctx.world.programmerInspect(frame.ctx.actor, assertObj(builtinArgs[0]), builtinArgs[1] ?? null, frame.ctx.definer);
      case "programmer_resolve_verb":
        if (builtinArgs.length !== 2) throw wooError("E_INVARG", "programmer_resolve_verb expects object and verb descriptor");
        return frame.ctx.world.programmerResolveVerb(frame.ctx.actor, assertObj(builtinArgs[0]), builtinArgs[1], frame.ctx.definer);
      case "programmer_list_verb":
        if (builtinArgs.length < 2 || builtinArgs.length > 3) throw wooError("E_INVARG", "programmer_list_verb expects object, descriptor, and optional opts");
        return frame.ctx.world.programmerListVerb(frame.ctx.actor, assertObj(builtinArgs[0]), builtinArgs[1], builtinArgs[2] ?? null, frame.ctx.definer);
      case "programmer_search":
        if (builtinArgs.length < 1 || builtinArgs.length > 2) throw wooError("E_INVARG", "programmer_search expects query and optional opts");
        return frame.ctx.world.programmerSearch(frame.ctx.actor, assertString(builtinArgs[0]), builtinArgs[1] ?? null, frame.ctx.definer);
      case "programmer_install_verb":
        if (builtinArgs.length < 3 || builtinArgs.length > 4) throw wooError("E_INVARG", "programmer_install_verb expects object, descriptor, source, and optional opts");
        return await frame.ctx.world.programmerInstallVerb(frame.ctx.actor, assertObj(builtinArgs[0]), builtinArgs[1], assertString(builtinArgs[2]), builtinArgs[3] ?? null, frame.ctx.definer);
      case "programmer_set_verb_info":
        if (builtinArgs.length < 2 || builtinArgs.length > 3) throw wooError("E_INVARG", "programmer_set_verb_info expects object, descriptor, and optional opts");
        return await frame.ctx.world.programmerSetVerbInfo(frame.ctx.actor, assertObj(builtinArgs[0]), builtinArgs[1], builtinArgs[2] ?? null, frame.ctx.definer);
      case "programmer_set_property_info":
        if (builtinArgs.length < 2 || builtinArgs.length > 3) throw wooError("E_INVARG", "programmer_set_property_info expects object, name, and optional opts");
        return await frame.ctx.world.programmerSetPropertyInfo(frame.ctx.actor, assertObj(builtinArgs[0]), assertString(builtinArgs[1]), builtinArgs[2] ?? null, frame.ctx.definer);
      case "programmer_trace":
        if (builtinArgs.length < 2 || builtinArgs.length > 3) throw wooError("E_INVARG", "programmer_trace expects object, descriptor, and optional opts");
        return frame.ctx.world.programmerTrace(frame.ctx.actor, assertObj(builtinArgs[0]), builtinArgs[1], builtinArgs[2] ?? null, frame.ctx.definer);
      case "editor_invoke":
        if (builtinArgs.length < 3 || builtinArgs.length > 4) throw wooError("E_INVARG", "editor_invoke expects editor, target, descriptor, and optional opts");
        return await frame.ctx.world.editorInvoke(frame.ctx, assertObj(builtinArgs[0]), assertObj(builtinArgs[1]), builtinArgs[2], builtinArgs[3] ?? null, frame.ctx.definer);
      case "editor_what":
        if (builtinArgs.length !== 0) throw wooError("E_INVARG", "editor_what expects no arguments");
        return frame.ctx.world.editorWhat(frame.ctx, frame.ctx.thisObj);
      case "editor_view":
        if (builtinArgs.length > 1) throw wooError("E_INVARG", "editor_view expects optional opts");
        return frame.ctx.world.editorView(frame.ctx, frame.ctx.thisObj, builtinArgs[0] ?? null);
      case "editor_replace":
        if (builtinArgs.length !== 1) throw wooError("E_INVARG", "editor_replace expects text");
        return frame.ctx.world.editorReplace(frame.ctx, frame.ctx.thisObj, assertString(builtinArgs[0]));
      case "editor_insert":
        if (builtinArgs.length !== 2) throw wooError("E_INVARG", "editor_insert expects line and text");
        return frame.ctx.world.editorInsert(frame.ctx, frame.ctx.thisObj, numeric(builtinArgs[0], "line"), assertString(builtinArgs[1]));
      case "editor_delete":
        if (builtinArgs.length < 1 || builtinArgs.length > 2) throw wooError("E_INVARG", "editor_delete expects start and optional end");
        return frame.ctx.world.editorDelete(frame.ctx, frame.ctx.thisObj, numeric(builtinArgs[0], "start"), builtinArgs.length > 1 && builtinArgs[1] !== null ? numeric(builtinArgs[1], "end") : null);
      case "editor_dry_run":
        if (builtinArgs.length !== 0) throw wooError("E_INVARG", "editor_dry_run expects no arguments");
        return await frame.ctx.world.editorDryRun(frame.ctx, frame.ctx.thisObj);
      case "editor_save":
        if (builtinArgs.length !== 0) throw wooError("E_INVARG", "editor_save expects no arguments");
        return await frame.ctx.world.editorSave(frame.ctx, frame.ctx.thisObj);
      case "editor_pause":
        if (builtinArgs.length !== 0) throw wooError("E_INVARG", "editor_pause expects no arguments");
        return await frame.ctx.world.editorPause(frame.ctx, frame.ctx.thisObj);
      case "editor_abort":
        if (builtinArgs.length !== 0) throw wooError("E_INVARG", "editor_abort expects no arguments");
        return await frame.ctx.world.editorAbort(frame.ctx, frame.ctx.thisObj);
      default:
        throw wooError("E_INVARG", `unknown builtin: ${name}`);
    }
  }
}

function makeFrame(ctx: CallContext, bytecode: TinyBytecode, args: WooValue[]): VmFrame {
  validateRuntimeBytecode(bytecode);
  const locals = new Array<WooValue>(bytecode.num_locals).fill(null);
  for (let i = 0; i < Math.min(args.length, locals.length); i++) locals[i] = cloneValue(args[i]);
  return {
    ctx,
    bytecode,
    args: cloneValue(args as WooValue) as WooValue[],
    stack: [],
    locals,
    handlers: [],
    pc: 0,
    ticksRemaining: bytecode.max_ticks ?? DEFAULT_TICKS,
    startedAt: Date.now(),
    activeWallMs: 0,
    memoryUsed: 0
  };
}

function validateRuntimeBytecode(bytecode: TinyBytecode): void {
  if (!Number.isInteger(bytecode.num_locals) || bytecode.num_locals < 0 || bytecode.num_locals > MAX_RUNTIME_LOCALS) {
    throw wooError("E_COMPILE", `bytecode num_locals exceeds limit ${MAX_RUNTIME_LOCALS}`);
  }
  if (!Number.isInteger(bytecode.max_stack) || bytecode.max_stack < 0 || bytecode.max_stack > MAX_RUNTIME_STACK) {
    throw wooError("E_COMPILE", `bytecode max_stack exceeds limit ${MAX_RUNTIME_STACK}`);
  }
}

function serializeVmFrames(frames: VmFrame[]): SerializedVmTask {
  return {
    version: 1,
    frames: frames.map(serializeVmFrame)
  };
}

function serializeVmFrame(frame: VmFrame): SerializedVmFrame {
  return {
    ctx: {
        space: frame.ctx.space,
        seq: frame.ctx.seq,
        session: frame.ctx.session,
      actor: frame.ctx.actor,
      player: frame.ctx.player,
      caller: frame.ctx.caller,
      callerPerms: frame.ctx.callerPerms,
      progr: frame.ctx.progr,
      thisObj: frame.ctx.thisObj,
      verbName: frame.ctx.verbName,
      definer: frame.ctx.definer,
      message: cloneValue(frame.ctx.message as unknown as WooValue) as unknown as Message,
      observations: cloneValue(frame.ctx.observations as unknown as WooValue) as unknown as Observation[]
    },
    bytecode: cloneValue(frame.bytecode as unknown as WooValue) as unknown as TinyBytecode,
    args: cloneValue(frame.args as WooValue) as WooValue[],
    stack: cloneValue(frame.stack as WooValue) as WooValue[],
    locals: cloneValue(frame.locals as WooValue) as WooValue[],
    handlers: cloneValue(frame.handlers as unknown as WooValue) as unknown as VmHandler[],
    pc: frame.pc,
    ticksRemaining: frame.ticksRemaining,
    startedAt: frame.startedAt,
    activeWallMs: frame.activeWallMs + Math.max(0, Date.now() - frame.startedAt),
    memoryUsed: frame.memoryUsed
  };
}

function hydrateVmFrame(world: CallContext["world"], frame: SerializedVmFrame, observations: Observation[]): VmFrame {
  const ctx: CallContext = {
      world,
      space: frame.ctx.space,
      seq: frame.ctx.seq,
      session: frame.ctx.session ?? null,
    actor: frame.ctx.actor,
    player: frame.ctx.player,
    caller: frame.ctx.caller,
    callerPerms: frame.ctx.callerPerms ?? frame.ctx.progr,
    progr: frame.ctx.progr,
    thisObj: frame.ctx.thisObj,
    verbName: frame.ctx.verbName,
    definer: frame.ctx.definer,
    message: cloneValue(frame.ctx.message as unknown as WooValue) as unknown as Message,
    observations,
    observe: (event) => {
      observations.push({ ...event, source: event.source ?? frame.ctx.space });
    }
  };
  return {
    ctx,
    bytecode: cloneValue(frame.bytecode as unknown as WooValue) as unknown as TinyBytecode,
    args: cloneValue(frame.args as WooValue) as WooValue[],
    stack: cloneValue(frame.stack as WooValue) as WooValue[],
    locals: cloneValue(frame.locals as WooValue) as WooValue[],
    handlers: cloneValue(frame.handlers as unknown as WooValue) as unknown as VmHandler[],
    pc: frame.pc,
    ticksRemaining: frame.ticksRemaining,
    startedAt: Date.now(),
    activeWallMs: frame.activeWallMs ?? 0,
    memoryUsed: frame.memoryUsed
  };
}

function tickWeight(op: string): number {
  if (op === "BUILTIN") return 5;
  if (op === "GET_PROP" || op === "SET_PROP") return 5;
  if (op === "CALL_VERB" || op === "PASS" || op === "EMIT") return 10;
  if (op === "MAKE_LIST" || op === "MAKE_MAP" || op === "LIST_APPEND" || op === "MAP_SET" || op === "INDEX_SET" || op === "STR_CONCAT" || op === "STR_INTERP") return 5;
  return 1;
}

function chargeTicks(frame: VmFrame, ticks: number): void {
  frame.ticksRemaining -= ticks;
  if (frame.ticksRemaining < 0) throw wooError("E_TICKS", "task exceeded tick budget");
}

function literal(bytecode: TinyBytecode, operand: WooValue | undefined): WooValue {
  const index = numeric(operand, "literal index");
  if (index < 0 || index >= bytecode.literals.length) throw wooError("E_RANGE", "literal index out of range", index);
  return bytecode.literals[index];
}

function localIndex(value: WooValue | undefined, length: number): number {
  const index = numeric(value, "local index");
  if (!Number.isInteger(index) || index < 0 || index >= length) throw wooError("E_RANGE", "local index out of range", index);
  return index;
}

function numeric(value: WooValue | undefined, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw wooError("E_TYPE", `${label} must be numeric`, value);
  return value;
}

function oneBasedIndex(value: WooValue): number {
  const index = numeric(value, "list index");
  if (!Number.isInteger(index)) throw wooError("E_TYPE", "list index must be integer", value);
  return index - 1;
}

function assertList(value: WooValue): WooValue[] {
  if (!Array.isArray(value)) throw wooError("E_TYPE", "expected list", value);
  return value;
}

function truthy(value: WooValue): boolean {
  return !(value === null || value === false || value === 0 || value === "");
}

function errorFromValue(value: WooValue): ErrorValue {
  if (isErrorValue(value) && typeof value.code === "string") return value;
  if (typeof value === "string") return wooError(value);
  return wooError("E_ERROR", "raised non-error value", value);
}

function normalizeVmError(err: unknown): ErrorValue {
  if (isErrorValue(err) && typeof err.code === "string") return err;
  if (err instanceof Error) return wooError("E_INTERNAL", err.message);
  return wooError("E_INTERNAL", "unknown VM error", String(err));
}

function attachVmTrace(error: ErrorValue, frames: VmFrame[], currentPc: number): ErrorValue {
  if (error.trace && error.trace.length > 0) return error;
  const trace = frames
    .map((frame, index) => vmTraceFrame(frame, index === frames.length - 1 ? currentPc : Math.max(0, frame.pc - 1)))
    .reverse();
  return { ...error, trace };
}

function vmTraceFrame(frame: VmFrame, pc: number): WooValue {
  const item: Record<string, WooValue> = {
    obj: frame.ctx.thisObj,
    verb: frame.ctx.verbName,
    definer: frame.ctx.definer,
    progr: frame.ctx.progr,
    pc
  };
  try {
    const verb = frame.ctx.world.ownVerb(frame.ctx.definer, frame.ctx.verbName);
    if (verb) {
      item.version = verb.version;
      const mapped = verb.line_map[String(pc)];
      if (mapped && typeof mapped === "object" && !Array.isArray(mapped)) {
        const map = mapped as Record<string, WooValue>;
        if (typeof map.line === "number") item.line = map.line;
        if (typeof map.column === "number") item.column = map.column;
        if (typeof map.end_line === "number") item.end_line = map.end_line;
        if (typeof map.end_column === "number") item.end_column = map.end_column;
      }
    }
  } catch {
    // Trace construction is diagnostic-only and must not mask the real error.
  }
  return item;
}

function typeName(value: WooValue): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "list";
  if (typeof value === "object") return "map";
  return typeof value;
}

function estimateSize(value: WooValue): number {
  if (value === null || typeof value === "boolean") return 8;
  if (typeof value === "number") return 8;
  if (typeof value === "string") return value.length * 2;
  if (Array.isArray(value)) return 16 + value.reduce<number>((sum, item) => sum + estimateSize(item), 0);
  return 16 + Object.entries(value as Record<string, WooValue>).reduce<number>((sum, [key, item]) => sum + key.length * 2 + estimateSize(item), 0);
}

type FastBuiltinResult = { handled: true; value: WooValue } | { handled: false };

function tryFastBuiltin(nameOrIndex: WooValue | undefined, builtinArgs: WooValue[], frame: VmFrame): FastBuiltinResult {
  const name = typeof nameOrIndex === "number"
    ? BUILTIN_NAMES[nameOrIndex]
    : typeof nameOrIndex === "string"
      ? nameOrIndex
      : "";
  if (name !== "isa") return { handled: false };
  if (builtinArgs.length !== 2) throw wooError("E_INVARG", "isa expects object and ancestor");
  const obj = assertObj(builtinArgs[0]);
  const ancestor = assertObj(builtinArgs[1]);
  if (obj === ancestor) return { handled: true, value: true };
  if (!frame.ctx.world.objects.has(obj)) return { handled: false };
  return { handled: true, value: frame.ctx.world.isDescendantOf(obj, ancestor) };
}

function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
  return value !== null && typeof value === "object" && typeof (value as Promise<T>).then === "function";
}
